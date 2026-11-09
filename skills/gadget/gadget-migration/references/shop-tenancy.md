# Shop tenancy and permissions

## What is this?

Shop tenancy means each store only reads and writes its own records. On Gadget it happened without code in your queries:

- **Reads:** the `shopify-app-users` role has a Gelly filter on every Shopify model, `where shopId == $session.shopId`. Custom models get the same filter when you add it.
- **Writes:** `preventCrossShopDataAccess(params, record)` in each action sets `shopId` on new records from the session, and rejects a write that names another store. Gadget's default action code calls it when the model has a `shopifyShop` relationship. It does nothing when the caller has no store, such as an API key with access control turned off or a scheduled action.

Both applied to calls from outside: the frontend, and loaders using the session's client. Code inside actions and routes was different. The `api` object there had admin access by default, so `api.auditLog.findMany()` in an action returned every store's records unless the code added its own `shopId` filter or used `api.actAsSession`. When you port that code, keep the filters it wrote by hand, and expect row-level security to reject the queries that read across stores on purpose.

On the new platform nothing does this unless you build it. Without it, `prisma.auditLog.findMany()` on an admin page returns the records of every store the app is installed on, not only the store viewing the page.

There are two ways to rebuild it. Pick one per app and use it everywhere.

| | Postgres row-level security | Filters in your data access code |
|---|---|---|
| Where the check lives | In the database, on every query | In one helper every query goes through |
| A query that forgets the store | Fails with an error | Returns every store's rows |
| Setup | A policy per table, a separate database role, a transaction per request | A helper and code review |
| Works with | Any client that can run SQL in a transaction, including through a pooler in transaction mode | Any client |

## Option A: row-level security

### 1. Add a policy to each table that has a `shop_id`

```sql
-- in db/migrations/shop_isolation.sql
alter table audit_log enable row level security;
alter table audit_log force row level security;

create policy audit_log_shop_isolation on audit_log
  using (shop_id = current_setting('app.shop_id')::bigint);
```

The `using` expression also checks inserts and updates, so a write with another store's `shop_id` fails with `new row violates row-level security policy`. That replaces `preventCrossShopDataAccess`. An update or delete aimed at another store's row by id doesn't fail. It matches 0 rows, so check the row count where the code expects a change.

### 2. Connect as a role that RLS applies to

Postgres skips RLS for superusers, for roles with `BYPASSRLS`, and for the table's owner unless the table has `force row level security`. The default user on many managed databases is one of these, so create a separate role for the app:

```sql
-- in db/migrations/app_role.sql
create role app_user login password 'change-me' nosuperuser nobypassrls;
grant select, insert, update, delete on all tables in schema public to app_user;
grant usage, select on all sequences in schema public to app_user;
-- tables and sequences this migration role creates later get the same grants
alter default privileges in schema public grant select, insert, update, delete on tables to app_user;
alter default privileges in schema public grant usage, select on sequences to app_user;
```

Run migrations as the owner role and the app as `app_user`. Without the two `alter default privileges` lines, the first table a later migration adds fails with `permission denied` for the app.

### 3. Set the store at the start of every transaction

```typescript
// in app/db/withShop.server.ts
import type { Prisma, PrismaClient } from "@prisma/client";

export function withShop<T>(prisma: PrismaClient, shopId: bigint, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx) => {
    // `true` scopes the setting to this transaction, so it never stays on a pooled connection
    await tx.$executeRaw`select set_config('app.shop_id', ${shopId.toString()}, true)`;
    return fn(tx);
  });
}
```

```typescript
const logs = await withShop(prisma, shopId, (tx) => tx.auditLog.findMany({ orderBy: { createdAt: "desc" }, take: 50 }));
```

The same with node-postgres:

```typescript
// in app/db/withShop.server.ts
import type { Pool, PoolClient } from "pg";

export async function withShop<T>(pool: Pool, shopId: bigint, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('app.shop_id', $1, true)", [shopId.toString()]);
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
```

And with Drizzle:

```typescript
// in app/db/withShop.drizzle.server.ts
import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

type Transaction = Parameters<Parameters<NodePgDatabase["transaction"]>[0]>[0];

export function withShop<T>(db: NodePgDatabase, shopId: bigint, fn: (tx: Transaction) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.shop_id', ${shopId.toString()}, true)`);
    return fn(tx);
  });
}
```

Prisma's interactive transactions time out after 5 seconds unless you pass `{ timeout }` as the second argument to `$transaction`. Every query in the callback has to use `tx`. A call on the outer `prisma`, `pool`, or `db` inside the callback runs on another connection with no store set, and fails.

### What a forgotten `withShop` does

A query that runs outside `withShop` fails instead of returning other stores' rows:

- On a connection that never set `app.shop_id`, `current_setting` raises `unrecognized configuration parameter "app.shop_id"`.
- On a pooled connection where an earlier transaction set it, the setting is back to an empty string after that transaction, and the `::bigint` cast raises `invalid input syntax for type bigint: ""`.

If you pass `false` as the third argument to `set_config`, the store stays on the connection after the transaction, and the next request that borrows it reads the previous store's rows. Always pass `true`.

All of this was run on Postgres 17, directly and through PgBouncer 1.23 in transaction mode. A pooler in transaction mode, such as Supabase's port 6543 or Neon's `-pooler` host, keeps one server connection for the whole transaction, so `set_config(..., true)` works through it. The `false` form is worse there: the pooler hands the same server connection to other clients, so the store leaks to a different process, not only to the next request in this one. RDS Proxy pins a client connection to one server connection once it sees `set_config`, which is correct but gives up the proxy's connection sharing for that client.

### ❌ Don't connect the app as the table owner or a superuser

```text
postgres://postgres:...@db/app   -- superuser: every policy is skipped, all stores' rows come back
```

`force row level security` makes the policy apply to the table's owner. Nothing makes it apply to a superuser or a `BYPASSRLS` role.

### Which store is the current one?

For requests from the embedded admin, the store comes from the verified session token (`session.shop` from the template's `authenticate.admin`, or `verifySessionToken` from [shopify-signatures.md](shopify-signatures.md)). Look up its id in your shops table once per request. For webhooks, use the `X-Shopify-Shop-Domain` header after the HMAC check. Never take the store from a request body or query parameter.

That lookup runs before `app.shop_id` is set, so it can't sit behind the policy. Leave the shop policy off the table you look the store up in and off the template's `Session` table, which `authenticate.admin` reads before any store is known. Both can hold access tokens, so reach them only through the lookup and the template, never through a generic query path.

### Code that works across stores

A scheduled job that prunes old rows for every store, a reconciliation loop, and a migration script all run without one current store. Under the policy they fail like any other query with no store set. Either loop over the stores and call `withShop` for each, or give those jobs their own database role with `bypassrls` and a connection string the web process never sees.

### Customer tenancy

If the app serves signed-in Shopify customers (the `shopify-storefront-customers` role, with filters such as `where customerId == $session.shopifyCustomerId`), each customer must only see their own rows inside the store. Add a second role for those requests and a restrictive policy, which narrows what the shop policy already allows:

```sql
-- in db/migrations/customer_isolation.sql
create role storefront_user login password 'change-me' nosuperuser nobypassrls;
grant select on customer_note to storefront_user;

create policy customer_note_customer_isolation on customer_note as restrictive for all to storefront_user
  using (customer_id = current_setting('app.customer_id')::bigint);
```

Requests from customers connect as `storefront_user` and set both `app.shop_id` and `app.customer_id` at the start of the transaction. Requests from the merchant's admin keep connecting as `app_user` and see every customer in their store. Take the customer id from a verified source: the `logged_in_customer_id` parameter of a verified app proxy request, or the `sub` claim of a verified customer account session token.

## Option B: filters in your data access code

Every query takes the store's id from one helper, and writes set `shop_id` from the session, never from the request:

```typescript
// in app/db/shopScoped.server.ts
import type { PrismaClient } from "@prisma/client";

export function shopScoped(prisma: PrismaClient, shopId: bigint) {
  return {
    auditLogs: {
      findMany: (args: { take?: number } = {}) => prisma.auditLog.findMany({ ...args, where: { shopId } }),
      create: (data: { event: string; orderId: bigint }) => prisma.auditLog.create({ data: { ...data, shopId } }),
      // updateMany with the shop in the filter changes 0 rows for another store's record
      update: (id: bigint, data: { event?: string }) => prisma.auditLog.updateMany({ where: { id, shopId }, data }),
    },
  };
}
```

This is simpler to set up, but a single query that skips the helper exposes every store's data, and nothing fails to tell you. If you choose it, add a lint rule or a test that greps for direct `prisma.<model>` calls outside the helper.

## Other roles

- **`signed-in` and custom roles** in web apps become checks in your routes against the signed-in user from your new sign-in provider.
- **The `unauthenticated` role.** Anything it could read or run on Gadget was public. List those grants from `accessControl/permissions.gadget.ts` and decide on purpose which of the new routes need no sign-in.
- **Gelly filters other than the shop filter** (for example `where userId == $user.id`) become either more RLS policies keyed on another setting, such as `app.user_id`, or `where` clauses in the helper.
- **Role assignments on users** (`roles` fields) export as role names from the Internal API, such as `signed-in`. Store them in a `text[]` column and check them in code.
- **API keys.** Each Gadget API key carried roles. Calls that used one, from another service or a script, need a new credential and the same checks on the new routes.

## Common pitfalls

- **Connecting as the table owner, a superuser, or a `BYPASSRLS` role.** Every policy is skipped. Check with `select rolsuper, rolbypassrls from pg_roles where rolname = current_user;`.
- **`set_config(..., false)` on a pooled connection.** The store leaks into the next request on that connection.
- **Reading the store from the request.** A merchant can send any `shopId` they like. Take it from the verified session token or the webhook header.
- **Background jobs without a store.** Jobs run outside any request, so pass the shop id in the job payload and call `withShop` inside the job.
- **Tables without `shop_id`.** Child records such as line items need their own `shop_id` column for a simple policy, or a policy that joins to the parent.
- **A new table with no policy.** A table without `enable row level security` is readable across stores by `app_user`. List the tables that have a `shop_id` column and no policy: `select c.table_name from information_schema.columns c join pg_class t on t.relname = c.table_name and t.relnamespace = 'public'::regnamespace where c.table_schema = 'public' and c.column_name = 'shop_id' and not t.relrowsecurity;`.
- **Expecting an error from a cross-store update.** It changes 0 rows without failing.

## Related references

- [actions-and-transactions.md](actions-and-transactions.md): the transaction each action needs anyway
- [background-jobs.md](background-jobs.md): passing the store into jobs
- [non-shopify-apps.md](non-shopify-apps.md): the same pattern keyed on users and teams, for apps without Shopify
