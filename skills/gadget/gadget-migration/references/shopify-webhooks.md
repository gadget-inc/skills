# Processing Shopify webhooks

## What is this?

On Gadget, a webhook turned into a model action run and nothing else. Behind that, Gadget did five things your new app has to do itself:

1. **Verify the HMAC.** See [shopify-signatures.md](shopify-signatures.md).
2. **Respond fast and work later.** Gadget answered as soon as the work was queued, then ran the action with up to 10 attempts in production, starting 2 seconds apart and doubling.
3. **Drop duplicates.** Shopify resends a webhook it thinks failed. Gadget dropped a second delivery with the same webhook id.
4. **Ignore stale payloads.** Shopify doesn't deliver in order. Gadget skipped a payload whose `updated_at` was older than the stored `shopifyUpdatedAt`.
5. **Keep child records in step.** When an order's line items changed, Gadget deleted stored line items that were missing from the new payload.

Here is what happens without them. Shopify needs a response within 5 seconds, counts anything outside the 200 range as a failure, including a redirect, and retries a failed delivery up to 8 times over 4 hours. A handler that takes 6 seconds to write an order processes it twice. An `orders/updated` for a change at 10:00:05 can arrive before the one for 10:00:02. A handler that writes whatever arrives last ends with the older data.

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

`authenticate.webhook` does one more thing: it loads the store's offline session and, when the access token has less than 5 minutes left, refreshes it before returning. If that refresh fails, it answers 500, although the HMAC was valid. So a store whose refresh token was retired during the move fails every webhook until its merchant opens the app, and Shopify drops each one after 8 retries. Your reconciliation is what recovers those. If webhook intake must not depend on token state, verify with `verifyWebhook` in that route instead.

Without the template, verify with `verifyWebhook` from [shopify-signatures.md](shopify-signatures.md) and read `X-Shopify-Webhook-Id`, `X-Shopify-Topic`, and `X-Shopify-Shop-Domain` from the headers.

If the app has no queue, Shopify can deliver to Google Cloud Pub/Sub or Amazon EventBridge instead: set the subscription's `uri` in `shopify.app.toml` to `pubsub://<project-id>:<topic-id>` or an EventBridge event source ARN. That removes the 5-second limit from your servers. These deliveries carry no HMAC, and Pub/Sub can deliver a message more than once, so the duplicate check below still applies.

## Or let Hookdeck answer Shopify

Hookdeck is a hosted webhook gateway that keeps HTTPS delivery. Shopify delivers to a Hookdeck source, Hookdeck answers Shopify, and then it delivers to your app and waits 60 seconds by default, up to 15 minutes per destination. The route can then do the work before it responds, with no queue of your own. Gadget's guide has the full setup: https://docs.gadget.dev/guides/moving-to-another-platform/hookdeck

Set it up like this:

- **Source:** type `SHOPIFY`, with the app's client secret. A delivery whose signature doesn't match gets a 401 and is recorded as `VERIFICATION_FAILED`. With the wrong secret, such as the development app's, Shopify retries each webhook for 4 hours and then drops it.
- **`uri` and destination:** Hookdeck forwards the path after the source URL. Put the route's path in the TOML `uri`, such as `https://hkdk.events/<source-id>/webhooks/orders/updated`, and only the app's origin in the destination URL. A destination URL that also has the path receives `/webhooks/orders/updated/webhooks/orders/updated` and gets a 404.
- **Retry rule:** add one. Exponential from 60,000 ms with 10 retries doubles the wait each time, so the retries cover at least 8.5 hours. Retry every response outside the 200 range, not only 5xx, so a 404 from a wrong path recovers once you fix it.
- **Deduplication rule:** include the field `headers.x-shopify-webhook-id`, with the maximum window of 1 hour. The window is in milliseconds (`3600000`) in the API and in the CLI's `--rules` JSON. The CLI's `--rule-deduplicate-window` help says seconds but passes the value to the API unchanged, so `3600` there is 3.6 seconds. Keep the `processed_webhook` check below anyway. Shopify can resend after an hour, and Hookdeck retries a delivery whose response it never got.
- **Delivery groups:** a key of `headers.x-shopify-shop-domain` gives each store its own rate. Group rates are per second, minute, or hour, not a concurrency limit.

Hookdeck forwards Shopify's body and headers unchanged, so `authenticate.webhook` and `verifyWebhook` still check Shopify's HMAC. Don't add a Hookdeck transformation that changes the body: even reformatted whitespace fails that check on every delivery. Hookdeck also signs each request in `x-hookdeck-signature`, plus `x-hookdeck-signature-2` while a rolled secret is still active. It's the same algorithm as Shopify's, a base64 HMAC-SHA256 of the raw body, keyed with the Hookdeck project's signing secret, so `verifyWebhook` checks it too:

```typescript
// in app/routes/webhooks.orders.updated.tsx
const rawBody = new Uint8Array(await request.clone().arrayBuffer());
const secret = process.env.HOOKDECK_WEBHOOK_SECRET!;
const fromHookdeck =
  (await verifyWebhook(rawBody, request.headers.get("x-hookdeck-signature"), secret)) ||
  (await verifyWebhook(rawBody, request.headers.get("x-hookdeck-signature-2"), secret));
if (!fromHookdeck) return new Response(undefined, { status: 401 });

// authenticate.webhook reads the original body, so the copy above leaves it intact
const { shop, payload, webhookId } = await authenticate.webhook(request);
```

What Hookdeck doesn't change:

- **Order.** Its retries and rate limits reorder webhooks further, so keep the `updated_at` check.
- **Missed webhooks.** A webhook Shopify never sends never reaches Hookdeck, so keep the reconciliation in [shopify-sync.md](shopify-sync.md).
- **Admin requests.** Hookdeck answers every request itself and can't return your app's response, so the app URL, app proxy, and extension routes go to the app directly.
- **Per-store subscriptions Gadget created.** They deliver to Gadget until you delete them, as in [cutover.md](cutover.md).

For a store-by-store cutover, filters on `x-shopify-shop-domain` can route each store's webhooks to Gadget or to the new app, which replaces the webhook half of a forwarding layer. A filter change only applies to webhooks received after it, so wait for a store's queued deliveries to Gadget to finish before moving its tokens. The guide has the order.

Limits that matter at Shopify volume, from Hookdeck's pricing and limits pages on 9 November 2026: the free Developer plan has 10,000 events a month, which an app on 300 stores uses up in hours. The Team plan starts at $39 a month, plus $3.00 per 100,000 events up to 5 million. Every plan includes 5 events per second per destination, and deliveries above that queue: 20,000 `products/update` webhooks from one bulk edit take about 67 minutes. Events are kept 3 days on Developer, 7 on Team, and 30 on Growth, and you can only retry or replay within that window.

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

If the Gadget app narrowed webhooks with `includeFields`, keep the same `include_fields` on the new subscriptions. `include_fields` narrows the payload. It doesn't stop deliveries: Shopify still sends a webhook when a field outside the list changes. The one exception is that Shopify drops a delivery whose narrowed payload is identical to another within a short window.

Whether to list `updated_at` is a trade. With it, the stale check has a value to compare, and no two payloads are identical, so every change arrives, including the echo of your app's own writes. Without it, Shopify drops many of those echoes, but the upsert above has no timestamp to compare, so compare fields instead, as the reconciliation upsert does.

If the Gadget app filtered webhooks with `shopifyFilter`, keep the filter too. Shopify applies it before sending, so without it the new app receives every change for the topic. On framework 1.7 and later the filter is already the `filter` of the subscription in `shopify.app.toml`, and it moves with the file. On earlier versions, and on 1.7 and later for models with metafield fields, it is `shopifyFilter` in the action's `triggers`, and the inventory script lists each one. Gadget also applied the filter to records its reconciliation found, so put the same condition in your reconciliation's query, or it writes the records the filter kept out.

## Install, reinstall, and uninstall

Gadget ran the `shopifyShop` `install` action once per store and `reinstall` when a store came back. The template's `hooks.afterAuth` is not an install hook, although Shopify's reference describes it as running after a merchant installs the app. It runs after every token exchange, and `authenticate.admin` exchanges a token whenever the store has no stored session or its stored access token has less than 5 minutes left.

Here is what porting install code into it unchanged does. An app on 300 stores sends a welcome email from `install`. After the move, no store has a session in the new app, so the first visit from each of the 300 merchants runs `afterAuth` and sends the email again. It runs again on any later visit that finds the stored token within 5 minutes of expiry.

So `afterAuth` asks your own table what happened, and one insert claims the install:

```typescript
// in app/shopify/afterAuth.server.ts
import type { Pool } from "pg";

type Admin = { graphql: (query: string) => Promise<Response> };
type Handlers = { onInstall: (shopId: bigint) => Promise<void>; onReinstall: (shopId: bigint) => Promise<void> };

// Call from hooks.afterAuth, which runs after every token exchange and not only on install.
export async function claimInstall(pool: Pool, admin: Admin, shop: string, handlers: Handlers) {
  // the session names the store by domain, and shopify_shop is keyed on Shopify's shop id, as on Gadget
  const { data } = await (await admin.graphql("{ shop { id } }")).json();
  const shopId = BigInt(data.shop.id.split("/").pop()); // gid://shopify/Shop/111222333

  // two requests can exchange tokens at the same moment: only one of them inserts the row
  const inserted = await pool.query("insert into shopify_shop (id, myshopify_domain, state) values ($1, $2, 'installed') on conflict (id) do nothing", [String(shopId), shop]);
  if (inserted.rowCount === 1) return handlers.onInstall(shopId);

  const returned = await pool.query("update shopify_shop set state = 'installed' where id = $1 and state = 'uninstalled'", [String(shopId)]);
  if (returned.rowCount === 1) await handlers.onReinstall(shopId);
}
```

```typescript
// in app/shopify.server.ts, inside shopifyApp({ ... })
hooks: {
  afterAuth: ({ session, admin }) => claimInstall(pool, admin, session.shop, { onInstall, onReinstall }),
},
```

Stores imported from Gadget already have a row with `state = 'installed'`, so their first visit runs neither handler. The insert commits before `onInstall` runs, so an `onInstall` that throws is not run again on the next visit. Have it queue one job and let the queue retry the work.

The `uninstall` action becomes the `app/uninstalled` webhook handler. Set `state = 'uninstalled'` there, which is what makes the next `afterAuth` for that store a reinstall. The template's own handler already deletes the store's sessions.

## Topics Gadget handled for you

| Gadget model action | Webhook topics |
|---|---|
| `shopifyShop` install, reinstall, uninstall | `app/uninstalled`. Install and reinstall come from `afterAuth` (see above) |
| `shopifyOrder` create, update, delete | `orders/create`, `orders/updated`, `orders/delete` |
| `shopifyProduct` create, update, delete | `products/create`, `products/update`, `products/delete` |
| `shopifyGdprRequest` create | `customers/data_request`, `customers/redact`, `shop/redact` in `compliance_topics` |

The inventory script lists the topics in `shopify.app.toml`. Apps on framework versions before 1.7 had per-store subscriptions instead; the topics are in each model action's trigger and in the Shopify connection settings.

`shop/redact` arrives 48 hours after the store uninstalls the app, so its handler must work without a session or an access token. The template's `authenticate.webhook` returns `session` as undefined when it has no session for the store, and the template's own `app/uninstalled` handler deletes the store's sessions. Shopify requires a 401 for a compliance webhook with a bad HMAC, which `authenticate.webhook` and the pattern in [shopify-signatures.md](shopify-signatures.md) both give. When you port the `shop/redact` handler, find the tables to clear by listing every table with a `shop_id` column from `information_schema.columns`, as the policy check in [shop-tenancy.md](shop-tenancy.md) does. A list kept by hand misses the table you add next year.

Subscriptions come in two kinds, and they fail differently. Shopify never deletes a failing subscription from `shopify.app.toml`. It deletes a per-store subscription, created through the Admin API, after 8 failed deliveries in a row. Gadget created per-store subscriptions for apps on framework versions before 1.7 and for metafield models, and [cutover.md](cutover.md) covers deleting them. Gadget registers them again when it sees the store reinstall or its scopes change, so check for them once more before you delete the Gadget app.

Gadget uses per-store subscriptions for models with metafield fields because subscriptions in `shopify.app.toml` can't ask for metafields. If a model you're moving has metafield fields, either create per-store subscriptions through the Admin API with `metafieldNamespaces` or `metafields`, or read the metafields from the Admin API after each webhook.

## Common pitfalls

- **Doing the work before responding.** Anything slower than 5 seconds is processed twice, unless a gateway such as Hookdeck answers Shopify for you.
- **A redirect on the webhook URL.** A trailing-slash or `www` redirect counts as a failed delivery. Give Shopify the final URL.
- **Recording the webhook id outside the write's transaction.** A failed job then marks a webhook processed that never was.
- **Checking `updated_at` in a separate `select`.** Two workers can both pass the check and the older one can write last. Put the check in the `where` of the upsert.
- **Pruning children from a narrowed payload.** Deletes every line item when `line_items` isn't in `include_fields`.
- **Porting install code into `afterAuth` as it is.** It runs for every existing store on its merchant's first visit after the move, and again after later token exchanges.
- **A host that scales to zero.** Shopify waits 5 seconds. A server that takes longer than that to start fails the first webhook after every quiet period. Keep one instance running, such as with Cloud Run's minimum instances, and don't take webhooks on a free tier that stops idle services.
- **Dropping `shopifyFilter`.** The new subscription delivers every change for the topic, not only the ones the Gadget action ran for.
- **Parsing ids as JavaScript numbers.** Store them in `bigint` columns, and convert with `BigInt(payload.id)`. Prisma maps `bigint` to `BigInt`.

## Related references

- [shopify-sync.md](shopify-sync.md): backfill and reconciliation, which catch webhooks Shopify never delivered
- [background-jobs.md](background-jobs.md): retries and per-store concurrency for the webhook queue
