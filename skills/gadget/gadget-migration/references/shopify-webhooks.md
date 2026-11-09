# Processing Shopify webhooks

## What is this?

On Gadget, a webhook turned into a model action run and nothing else. Behind that, Gadget did five things your new app has to do itself:

1. **Verify the HMAC.** See [shopify-signatures.md](shopify-signatures.md).
2. **Respond fast and work later.** Gadget answered as soon as the work was queued, then ran the action with up to 10 attempts in production, starting 2 seconds apart and doubling.
3. **Drop duplicates.** Shopify resends a webhook it thinks failed. Gadget dropped a second delivery with the same webhook id.
4. **Ignore stale payloads.** Shopify doesn't deliver in order. Gadget skipped a payload whose `updated_at` was older than the stored `shopifyUpdatedAt`.
5. **Keep child records in step.** When an order's line items changed, Gadget deleted stored line items that were missing from the new payload.

Here is what happens without them. Shopify needs a response within 5 seconds and retries a failed delivery up to 8 times over 4 hours. A handler that takes 6 seconds to write an order processes it twice. An `orders/updated` for a change at 10:00:05 can arrive before the one for 10:00:02. A handler that writes whatever arrives last ends with the older data.

## Respond within 5 seconds

Verify, queue, and respond. Do the work in the job.

```typescript
// in app/routes/webhooks.orders.updated.tsx
import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { webhookQueue } from "../queues.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload, webhookId } = await authenticate.webhook(request);

  await webhookQueue.add(
    topic,
    { shop, payload, webhookId },
    {
      // drops a second delivery of the same webhook for 24 hours
      deduplication: { id: webhookId, ttl: 24 * 60 * 60 * 1000 },
      // 10 attempts starting 2 seconds apart, like Gadget's webhook retries
      attempts: 10,
      backoff: { type: "exponential", delay: 2000 },
    }
  );
  return new Response();
};
```

Without the template, verify with `verifyWebhook` from [shopify-signatures.md](shopify-signatures.md) and read `X-Shopify-Webhook-Id`, `X-Shopify-Topic`, and `X-Shopify-Shop-Domain` from the headers.

If the app has no queue, Shopify can deliver to Google Cloud Pub/Sub or Amazon EventBridge instead: set the subscription's `uri` in `shopify.app.toml` to `pubsub://<project-id>:<topic-id>` or an EventBridge event source ARN. That removes the 5-second limit from your servers. These deliveries carry no HMAC.

## Drop duplicate deliveries

A queue's deduplication covers deliveries that arrive while the job is known to the queue. For a guarantee that outlives the queue, record the webhook id in the same transaction as the write:

```sql
-- in db/migrations/processed_webhook.sql
create table processed_webhook (
  webhook_id text primary key,
  received_at timestamptz not null default now()
);
```

```typescript
// in app/jobs/processWebhook.server.ts
await withShop(pool, shopId, async (client) => {
  const { rowCount } = await client.query("insert into processed_webhook (webhook_id) values ($1) on conflict do nothing", [webhookId]);
  if (rowCount === 0) return; // already processed

  await upsertOrder(client, shopId, payload);
});
```

Because the insert and the write commit together, a job that fails halfway leaves no record of the id, and the retry processes the webhook. Recording the id in its own statement first would make the retry skip a webhook that was never processed. Delete rows older than a week on a schedule.

`X-Shopify-Webhook-Id` identifies one delivery and stays the same across retries. Two subscriptions to the same topic get different webhook ids for the same change. They share `X-Shopify-Event-Id`, so use that if you subscribe twice and want one run.

## Ignore stale payloads

Make the check part of the write, so two workers can't race between a read and a write:

```sql
-- in app/sql/upsert_order_from_webhook.sql
insert into shopify_order (id, shop_id, total_price, financial_status, shopify_updated_at)
values ($1, $2, $3, $4, $5)
on conflict (id) do update
  set total_price = excluded.total_price,
      financial_status = excluded.financial_status,
      shopify_updated_at = excluded.shopify_updated_at
  where shopify_order.shopify_updated_at is null
     or shopify_order.shopify_updated_at < excluded.shopify_updated_at;
```

With Prisma, run it with `prisma.$executeRaw`, because Prisma's `upsert` has no conditional update. `$executeRaw` returns the number of rows written, so `0` means the payload was stale.

When the two timestamps are equal, this keeps the stored row, which is what Gadget did for most webhooks. `updated_at` only has one-second precision, so two changes in the same second share a timestamp. Gadget's reconciliation compared fields in that case, and so should yours:

```sql
-- in app/sql/upsert_order_from_reconciliation.sql
insert into shopify_order (id, shop_id, total_price, financial_status, shopify_updated_at)
values ($1, $2, $3, $4, $5)
on conflict (id) do update
  set total_price = excluded.total_price,
      financial_status = excluded.financial_status,
      shopify_updated_at = excluded.shopify_updated_at
  where shopify_order.shopify_updated_at is null
     or shopify_order.shopify_updated_at < excluded.shopify_updated_at
     or (shopify_order.shopify_updated_at = excluded.shopify_updated_at
         and (shopify_order.total_price, shopify_order.financial_status)
             is distinct from (excluded.total_price, excluded.financial_status));
```

Gadget made two more exceptions. Delete webhooks always ran, since their payload has no `updated_at`. And for `orders/create` and `orders/updated` with equal timestamps but a different payment status, it read the order again from Shopify.

## Keep child records in step

Order payloads carry their line items. Write the parent and the children in one transaction, and delete stored children the payload no longer has:

```sql
-- in app/sql/prune_line_items.sql
delete from shopify_order_line_item
where order_id = $1
  and not (id = any($2::bigint[]));
```

Only prune when the payload includes the child array. A payload narrowed with `include_fields` that leaves out `line_items` says nothing about them.

Handle the delete topics too, such as `orders/delete` and `products/delete`. Their payload is just `{ "id": ... }`. Give child tables a foreign key with `on delete cascade`, or delete the children in the same transaction.

## Do work only when a field you care about changed

Gadget actions often checked `record.changed("financialStatus")` before doing work. Lock the row, read the old value, write, and compare, all in one transaction:

```typescript
const before = await client.query("select financial_status from shopify_order where id = $1 for update", [orderId]);
const written = await client.query(upsertOrderFromWebhook, values);
const changed = written.rowCount === 1 && before.rows[0]?.financial_status !== payload.financial_status;
// the timestamp in the id lets a second payment after a refund queue its own job
if (changed) await jobs.add("orderPaid", { orderId }, { jobId: `order-paid-${orderId}-${payload.updated_at}` });
```

This also stops echo loops, where your app writes to Shopify, Shopify sends the change back as a webhook, and the handler writes to Shopify again.

If the Gadget app narrowed webhooks with `includeFields`, keep the same `include_fields` on the new subscriptions, and keep `updated_at` in each list so the stale check has a value to compare. Shopify still sends a webhook when a field outside the list changes, and it may skip deliveries whose narrowed payload is identical to the last one.

## Topics Gadget handled for you

| Gadget model action | Webhook topics |
|---|---|
| `shopifyShop` install, uninstall | `app/uninstalled` (install comes from your auth flow) |
| `shopifyOrder` create, update, delete | `orders/create`, `orders/updated`, `orders/delete` |
| `shopifyProduct` create, update, delete | `products/create`, `products/update`, `products/delete` |
| `shopifyGdprRequest` create | `customers/data_request`, `customers/redact`, `shop/redact` in `compliance_topics` |

The inventory script lists the topics in `shopify.app.toml`. Apps on framework versions before 1.7 had per-store subscriptions instead; the topics are in each model action's trigger and in the Shopify connection settings.

`shop/redact` arrives after the store uninstalls the app, so its handler must work without a session or an access token. The template's `authenticate.webhook` returns `session` as undefined in that case.

## Common pitfalls

- **Doing the work before responding.** Anything slower than 5 seconds is processed twice.
- **Recording the webhook id outside the write's transaction.** A failed job then marks a webhook processed that never was.
- **Checking `updated_at` in a separate `select`.** Two workers can both pass the check and the older one can write last. Put the check in the `where` of the upsert.
- **Pruning children from a narrowed payload.** Deletes every line item when `line_items` isn't in `include_fields`.
- **Parsing ids as JavaScript numbers.** Store them in `bigint` columns, and convert with `BigInt(payload.id)`. Prisma maps `bigint` to `BigInt`.

## Related references

- [shopify-sync.md](shopify-sync.md): backfill and reconciliation, which catch webhooks Shopify never delivered
- [background-jobs.md](background-jobs.md): retries and per-store concurrency for the webhook queue
