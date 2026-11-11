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

## Delete records Shopify deleted before the switch

A reconciliation asks for records updated since its last run, and a deleted record is never in that answer. A record deleted after the move-day backfill and before the switch sends its delete webhook to Gadget only, so the new database keeps it ([Keep Shopify data in sync](https://docs.gadget.dev/guides/moving-to-another-platform#keep-shopify-data-in-sync)). Close that gap once, in the catch-up step of the cutover ([cutover.md](cutover.md), step 9 of [Cut over to the new platform](https://docs.gadget.dev/guides/moving-to-another-platform#cut-over-to-the-new-platform)): for each store and each Shopify model your app deletes records from, list the ids Shopify returns now and delete the rows missing from the list.

An id missing from the list proves a deletion only for a row the list would have returned. A row whose `shopify_updated_at` is later than the moment the list started may be a record created while it ran, so it stays. Another store's rows were never in this store's list, so the delete filters on `shop_id`. An order older than 60 days is missing from every list made without the `read_all_orders` scope, so the caller passes `createdSince` and older rows stay. A partial list fails the same test: a failed or cancelled bulk operation's file holds only some records, and deleting from it removes the rest.

```typescript
// in app/jobs/deleteMissing.server.ts
import type { Pool, PoolClient } from "pg";

// Deletes one store's rows whose ids a complete list from Shopify doesn't contain, and returns their ids.
// Rename shopify_updated_at and shopify_created_at if your tables store Shopify's times under other names.
export async function deleteMissing(
  db: Pool | PoolClient,
  { shopId, table, currentIds, listStartedAt, createdSince }: { shopId: bigint; table: string; currentIds: Set<bigint>; listStartedAt: Date; createdSince?: Date }
): Promise<bigint[]> {
  if (!/^[a-z_][a-z0-9_]*$/.test(table)) throw new Error(`unexpected table name: ${table}`);
  const values: unknown[] = [shopId.toString(), [...currentIds].map(String), listStartedAt];
  // rows created before createdSince are outside what the query can return, so they stay
  let window = "";
  if (createdSince) {
    values.push(createdSince);
    window = "and stored.shopify_created_at >= $4";
  }
  // a row updated after the list started stays, and so does a row with no Shopify time
  const { rows } = await db.query(
    `delete from ${table} as stored
     where stored.shop_id = $1
       and stored.shopify_updated_at < $3
       ${window}
       and not exists (select 1 from unnest($2::bigint[]) as listed(id) where listed.id = stored.id)
     returning stored.id`,
    values
  );
  return rows.map((row) => BigInt(row.id));
}
```

`not exists` over `unnest` lets Postgres hash the list, so one statement handles a large store. In a local test, a table of 1,000,000 orders and a list of 999,000 ids took 0.6 seconds and deleted the 1,000 missing rows.

The list is a bulk query with only `id`. This example is for orders:

```typescript
// in app/jobs/sweepDeletedOrders.server.ts
const START_ID_LIST = `#graphql
  mutation StartIdList($query: String!) {
    bulkOperationRunQuery(query: $query) {
      bulkOperation { id status createdAt }
      userErrors { field message }
    }
  }`;

const response = await admin.graphql(START_ID_LIST, { variables: { query: "{ orders { edges { node { id } } } }" } });
const { data } = await response.json();
if (data.bulkOperationRunQuery.userErrors.length) throw new Error(JSON.stringify(data.bulkOperationRunQuery.userErrors));
// Shopify's clock, which also sets the updated_at values stored in shopify_updated_at
const listStartedAt = new Date(data.bulkOperationRunQuery.bulkOperation.createdAt);

// once bulkOperation(id:) reports COMPLETED, stream every line of its url as in "Backfill with bulk operations"
const currentIds = new Set<bigint>();
for await (const line of lines) if (line) currentIds.add(BigInt(JSON.parse(line).id.split("/").pop()));

const deleted = await deleteMissing(pool, {
  shopId,
  table: "shopify_order",
  currentIds,
  listStartedAt,
  // without read_all_orders the list holds the last 60 days of orders; keep a day of margin
  createdSince: hasReadAllOrders ? undefined : new Date(listStartedAt.getTime() - 59 * 24 * 60 * 60 * 1000),
});
console.log(`deleted ${deleted.length} orders from shop ${shopId}`, deleted.map(String));
```

Start each list after webhooks stop reaching Gadget. A record deleted while the list runs, after the query already read it, stays in the list, and if its delete webhook went to Gadget nothing removes it. In a staged move, sweep each store after its own switch. Gadget ran its delete action when each of these webhooks arrived, so delete the rows without the side effects your delete handler adds. Child rows such as line items go with their parent only through `on delete cascade`; otherwise sweep their table too. Keep the logged ids: if a list turns out wrong, they are the records to restore from your export.

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
- **Keeping records deleted before the switch.** Their delete webhooks went to Gadget, and no reconciliation finds them. Sweep each store once after the switch.
- **Deleting from an incomplete list.** A failed bulk operation's file, or a list without `read_all_orders` and no `createdSince`, deletes records that still exist.
- **Requests from a host that isn't on the app's IP allowlist.** Shopify answers `403`. See [cutover.md](cutover.md).

## Related references

- [shopify-webhooks.md](shopify-webhooks.md): the upserts both jobs use
- [shopify-tokens.md](shopify-tokens.md): the token each job calls Shopify with
