# Backfilling and reconciling Shopify data

## What is this?

Gadget kept Shopify models current in three ways: webhooks, a sync when a store installed the app (if the install action called `api.shopifySync.run`), and a daily reconciliation that looked back 25 hours for records your app didn't receive and ran your model actions for them. Shopify doesn't guarantee every webhook arrives and recommends reconciliation jobs, so the new app needs two jobs besides its webhook handlers:

- **A backfill**, which loads a store's existing data at install, after the move, and when you add a model.
- **A reconciliation**, which runs on a schedule and asks each store for records updated since the last run.

Both write through the same stale-payload check as the webhooks in [shopify-webhooks.md](shopify-webhooks.md).

## Backfill with bulk operations

Paging through a connection stops at 25,000 objects, and every page counts against the store's rate limit. A bulk operation has neither problem: Shopify runs the query on its side, outside the rate limit, and gives you a JSONL file.

```typescript
// in app/jobs/backfill.server.ts
const START_BULK_QUERY = `#graphql
  mutation StartBackfill($query: String!) {
    bulkOperationRunQuery(query: $query) {
      bulkOperation { id status }
      userErrors { field message }
    }
  }`;

const ORDERS_QUERY = `{
  orders {
    edges {
      node {
        id
        updatedAt
        totalPriceSet { shopMoney { amount } }
        displayFinancialStatus
        lineItems {
          edges { node { id quantity sku } }
        }
      }
    }
  }
}`;

const response = await admin.graphql(START_BULK_QUERY, { variables: { query: ORDERS_QUERY } });
const { data } = await response.json();
if (data.bulkOperationRunQuery.userErrors.length) throw new Error(JSON.stringify(data.bulkOperationRunQuery.userErrors));
```

Subscribe to the `bulk_operations/finish` topic to hear when it ends, then read its `url` with `bulkOperation(id:)` on API version 2026-01 and later (`currentBulkOperation` before that). Shopify says that webhook isn't guaranteed, so also poll with the same query. The result URL expires after a week, and Shopify stops an operation that runs longer than 10 days.

Each line of the file is one node. Nested nodes come on their own lines after their parent, with a `__parentId`:

```jsonl
{"id":"gid://shopify/Order/5123456789","updatedAt":"2026-11-08T10:00:05Z","displayFinancialStatus":"PAID"}
{"id":"gid://shopify/LineItem/111","quantity":2,"sku":"TEE-M","__parentId":"gid://shopify/Order/5123456789"}
```

Stream it line by line instead of loading it into memory:

```typescript
// in app/jobs/backfill.server.ts
import { createInterface } from "node:readline";
import { Readable } from "node:stream";

const file = await fetch(resultUrl);
const lines = createInterface({ input: Readable.fromWeb(file.body as any) });
for await (const line of lines) {
  if (!line) continue;
  const node = JSON.parse(line);
  const id = BigInt(node.id.split("/").pop());
  if (node.__parentId) await upsertLineItem(shopId, BigInt(node.__parentId.split("/").pop()), id, node);
  else await upsertOrder(shopId, id, node);
}
```

Limits to plan around:

- **Concurrency:** on API version 2026-01 and later, an app can run 5 bulk queries per store at once. Earlier versions allow 1.
- **Shape:** up to 5 connections in one query, nested at most 2 levels.
- **IP allowlist:** from 12 November 2026 Shopify blocks bulk operations from public apps that have no IP allowlist. See [cutover.md](cutover.md).
- **Orders older than 60 days** need the `read_all_orders` scope. Without it the backfill silently returns only recent orders.
- **GraphQL ids:** bulk results use global ids such as `gid://shopify/Order/5123456789`. The number at the end is the id Gadget stored, so keep that.
- **Field names:** GraphQL fields differ from Gadget's REST-shaped fields, such as `displayFinancialStatus` for `financialStatus` and `totalPriceSet` for `totalPrice`. Map each one you kept.

## Reconcile on a schedule

Once a day, ask each store for records updated since the last successful run, with a margin, and write them with the reconciliation upsert from [shopify-webhooks.md](shopify-webhooks.md):

```typescript
// in app/jobs/reconcile.server.ts
const RECONCILE_ORDERS = `#graphql
  query ReconcileOrders($query: String!, $after: String) {
    orders(first: 250, after: $after, query: $query, sortKey: UPDATED_AT) {
      nodes { id updatedAt displayFinancialStatus totalPriceSet { shopMoney { amount } } }
      pageInfo { hasNextPage endCursor }
    }
  }`;

const since = new Date(lastRunAt.getTime() - 60 * 60 * 1000).toISOString(); // one hour of overlap
let after: string | null = null;
do {
  const response = await admin.graphql(RECONCILE_ORDERS, { variables: { query: `updated_at:>='${since}'`, after } });
  const { data } = await response.json();
  // the same handler the webhook job calls, built as in "Do work only when a field you care about changed" in shopify-webhooks.md:
  // a missed webhook still sends its email, and an order the webhooks already wrote does nothing
  for (const order of data.orders.nodes) await handleOrderUpdated(shopId, order, { source: "reconciliation" });
  after = data.orders.pageInfo.hasNextPage ? data.orders.pageInfo.endCursor : null;
} while (after);
```

Gadget ran the whole model action for each record its reconciliation found, `onSuccess` included, with `trigger.type` set to `shopify_webhook_reconciliation`. A reconciliation that only upserts rows repairs the data and nothing else: an `orders/updated` webhook Shopify never delivered leaves the order correct a day later, and the "order paid" email it should have caused is never sent. So call the ported action, and have it pick the reconciliation upsert when `source` says so. Skip the work when the upsert wrote no row, or every nightly run repeats the side effects for records that didn't change.

The backfill on the day of the move is the opposite case. Gadget already ran your actions for those records, so a backfill that calls the same function sends every email a second time. Pass `source: "backfill"` and skip the side effects for it, the way an action that read `trigger.type` skipped them for `shopify_sync`.

Some stores Gadget lists as installed can't be called. Shopify answers `402` for a store frozen for an unpaid bill, `423` for a locked store, and `401` when the token was revoked. These fail the same way on every attempt, so catch the error per store, record the store, and go on to the next one. A backfill or reconciliation that throws on the first such store never reaches the stores after it.

Run the reconciliation per store as a job with a concurrency limit per store ([background-jobs.md](background-jobs.md)), so one large store doesn't use another job's share of that store's rate limit.

Some Shopify models have no webhook topic, such as `shopifyFile`. Gadget kept them current with the `scheduledShopifySync` global action. Add them to the reconciliation, or they stop updating after the move.

## Pace calls to each store

Shopify's GraphQL Admin API gives each store 100 points per second on most plans, 200 on Advanced, 1,000 on Shopify Plus, and 2,000 on Shopify for enterprise. One query can cost at most 1,000 points. The limit is counted per app and store, and the new app is the same Shopify app as the Gadget one, so while both run they draw on one allowance for each store.

Gadget paced calls per store. Each response reports what's left in `extensions.cost.throttleStatus`, so wait when the next query would overdraw it. The template's `admin.graphql` throws on a throttled response instead of returning it, so catch that too:

```typescript
// in app/shopify/paced.server.ts
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function pacedGraphql(admin: { graphql: Function }, query: string, variables: object, estimatedCost = 100) {
  for (;;) {
    let body: any;
    try {
      body = await (await admin.graphql(query, { variables })).json();
    } catch (error: any) {
      // the template throws a throttled response, with Shopify's errors on error.body.errors.graphQLErrors
      const throttled = error?.body?.errors?.graphQLErrors?.some((item: any) => item.extensions?.code === "THROTTLED");
      if (!throttled) throw error;
      await sleep(1000);
      continue;
    }
    const status = body.extensions?.cost?.throttleStatus;
    if (status && status.currentlyAvailable < estimatedCost) {
      await sleep(((estimatedCost - status.currentlyAvailable) / status.restoreRate) * 1000);
    }
    return body;
  }
}
```

## Common pitfalls

- **Paging a large backfill instead of using a bulk operation.** It stops at 25,000 objects and uses the store's whole rate limit.
- **No `read_all_orders`.** The backfill looks complete and holds 60 days of orders.
- **A reconciliation with the strict `<` check.** It never repairs a change made in the same second as the previous one.
- **A reconciliation that only writes rows.** The record is repaired and the email or job its webhook would have caused never happens.
- **Running side effects from the move-day backfill.** Gadget already ran them once for every record.
- **Stopping on one store's error.** Frozen (`402`), locked (`423`), and revoked (`401`) stores fail every time. Record them and move on.
- **Forgetting sync-only models.** Models without webhooks stop updating the day you switch.
- **Requests from a host that isn't on the app's IP allowlist.** Shopify answers `403`. See [cutover.md](cutover.md).

## Related references

- [shopify-webhooks.md](shopify-webhooks.md): the upserts both jobs use
- [shopify-tokens.md](shopify-tokens.md): the token each job calls Shopify with
