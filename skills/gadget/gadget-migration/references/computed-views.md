# Replacing computed views

## What is this?

Computed views are read-only Gelly queries that aggregate across records. Apps on framework version 1.4 and later can have them in three places:

| Where | How it is called |
|---|---|
| `api/views/finishedReport.gelly` | `api.finishedReport()` and `useView(api.finishedReport)` |
| `api/models/customer/views/summary.gelly` | `api.customer.summary(...)` |
| An inline string | `api.view("{ count(customers) }")`, `api.customer.view("{ count(id) }")`, and `useView("{ ... }")` |

`ggt pull` downloads the `.gelly` files, but nothing outside Gadget runs Gelly. Each view becomes a SQL query. Find them with a search for `.gelly` files under `api/views` and `api/models/*/views`, and for `.view(` and `useView(` in code. Computed fields are a separate feature, covered in [schema-mapping.md](schema-mapping.md).

## The part that is easy to lose

A view ran with the caller's permissions. Gadget applied the caller's model filters before it computed anything, so `{ count(widgets) }` called from a merchant's browser counted that store's widgets, with no `where` clause in the Gelly.

Translate the Gelly literally and the store condition is gone:

```sql
select count(*) from widget; -- counts every store's widgets
```

On an app installed on 300 stores, a dashboard tile built on that query shows each merchant the total for all 300. Every view called from the frontend needs the store condition written into its SQL, or row-level security underneath it ([shop-tenancy.md](shop-tenancy.md)). Views called with `api.actAsAdmin` or from server code as an admin saw every record on purpose, so check which kind each call site is.

## ✅ A view, before and after

```gelly
// in api/views/finishedReport.gelly
view finishedReport {
  todos {
    day: dateTrunc(part: "day", date: finishedAt)
    count(1)
    [
      group by dateTrunc(part: "day", date: finishedAt)
      where finishedAt != null
    ]
  }
}
```

```sql
-- in db/queries/finished_report.sql
select date_trunc('day', finished_at at time zone 'UTC') as day, count(*)::int as count
from todo
where shop_id = $1
  and finished_at is not null
group by 1
order by 1
limit 10000;
```

What changed besides the syntax:

- **`where shop_id = $1`** replaces the permission filter Gadget applied for you.
- **`at time zone 'UTC'`** pins the day boundary. `date_trunc` on a `timestamptz` uses the session's time zone, so the same query returns different days on a server set to another zone.
- **`order by`** is explicit. A grouped query has no order without one.
- **`limit`** is explicit. Gadget raised `GGT_GELLY_RESULT_TRUNCATED` past 10,000 rows at one level. SQL returns every row unless you stop it.

A view with variables, such as `view ($startDate: Date, $endDate: Date) { sum(orders.totalPrice, where: ...) }`, becomes the same query with `$2` and `$3` parameters. Never build the SQL by joining strings.

## Where to run it

Gadget ran views on a read replica, so a slow report never slowed down writes. On the new platform a report runs on the primary unless you point it elsewhere. For reports that scan large tables, use a read replica if your database has one, set a `statement_timeout` on the connection the reports use, or precompute the numbers in a scheduled job.

`live: true` never worked with views, so there is no realtime behavior to keep.

## Common pitfalls

- **Dropping the tenant filter.** The Gelly has no store condition because Gadget added it. The SQL needs one.
- **Day boundaries in the wrong zone.** Pin the zone in the query.
- **No row limit.** A view that returned a few hundred groups on Gadget returns millions when a filter is missed.
- **Missing inline views.** `api.view("...")` and `api.<model>.view("...")` strings don't live in `.gelly` files. Search the code for them.
- **Summing a text column.** Money fields on Shopify models are strings in Gadget. Cast them, or store them as `numeric` ([schema-mapping.md](schema-mapping.md)).

## Related references

- [schema-mapping.md](schema-mapping.md): computed fields, which become SQL views or queries
- [shop-tenancy.md](shop-tenancy.md): the filter every query needs
