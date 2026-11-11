# Mapping Gadget models to database tables

## What is this?

Each Gadget model becomes a table, and each stored field becomes a column. Gadget's internal column names mean nothing outside Gadget, so name columns after the field's API identifier, in snake_case: `totalPrice` becomes `total_price`. The field types are in each model's `schema.gadget.ts`, and `scripts/inventory.ts` lists them with a suggested table name.

Every model also has `id`, `createdAt`, and `updatedAt`, which its schema file does not list. Keep all three: `updated_at` is what the catch-up export in [data-export.md](data-export.md) compares.

## Field types

| Gadget field type (`type:` in `schema.gadget.ts`) | Postgres column | Prisma |
|---|---|---|
| id | `bigint` primary key. Keep the exported values | `BigInt @id @default(autoincrement())`, or `BigInt @id` for Shopify models |
| `string`, `email`, `url`, `color` | `text`, with a `check` for validations you relied on | `String` |
| `number` | `numeric` | `Decimal @db.Decimal` |
| `boolean` | `boolean` | `Boolean` |
| `dateTime` | `timestamptz`, or `date` when `includeTime` is false. Cast the exported string straight to `date`, not through `timestamptz` | `DateTime @db.Timestamptz`, or `DateTime @db.Date` |
| `enum` | `text` with a `check`, unless `acceptUnlistedOptions` is true | `String`, or a Prisma `enum` |
| `enum` with `acceptMultipleSelections` | `text[]` | `String[]` |
| `json` | `jsonb` | `Json` |
| `richText` | `text` holding the markdown. The export gives `{ markdown }` | `String` |
| `vector` | `vector(n)` from pgvector, where `n` is the embedding length | `Unsupported("vector(1536)")` |
| `file` | Columns for the storage key, file name, MIME type, and size | Four fields |
| `encryptedString` | `text`, encrypted by your app or a key service | `String` |
| `password` | Usually lives in your sign-in provider | |
| `roleList` | `text[]` | `String[]` |
| `belongsTo` | `bigint` column named `<field>_id` | `BigInt` plus a `@relation` |
| `hasOne`, `hasMany` | No column. The other table holds the key | A relation field |
| `hasManyThrough` | The join model's table, exported like any other model | Two relations through the join model |
| `computed` | A view or a query | Nothing stored |
| `money` (deprecated) | `bigint` for the amount and `text` for the currency. The export gives `{ amount, currency }` with a whole-number amount | `BigInt` and `String` |
| `recordState` (deprecated), and `state` on `shopifyShop` | `text` | `String` |

## Decisions the table hides

**`user` is not a table name.** `create table user` fails with `syntax error at or near "user"`, because `user` is a reserved word in Postgres. `order` and `group` fail the same way. Name the tables `users`, `orders`, and `groups`. A namespaced model such as `billing/invoice` can become `billing_invoice`, or `invoice` in a `billing` schema.

**Numbers are exact on Gadget.** Gadget stores `number` fields in a Postgres `decimal` column. In a `double precision` column, `0.1 + 0.2` is `0.30000000000000004`, so order totals drift as you sum them. Use `numeric`. In Prisma, write `Decimal @db.Decimal`: a bare `Decimal` becomes `decimal(65,30)`, which pads every value to 30 decimal places.

**Gadget enforces no foreign keys.** A `belongsTo` can point at a record that no longer exists. Find those before you add a constraint, or the migration fails:

```sql
-- in db/checks/orphaned_widgets.sql
select widget.id, widget.shop_id
from widget
left join shopify_shop on shopify_shop.id = widget.shop_id
where widget.shop_id is not null
  and shopify_shop.id is null;
```

Load parent tables before child tables once the constraints exist, or add the constraints after every table is loaded.

**Gadget indexed what Postgres doesn't.** Gadget kept an index on every `belongsTo` field, and on every other field with filtering and sorting on, which is every field unless `filterIndex: false` turned it off (framework 1.5 and later). Postgres indexes primary keys and unique constraints only. A foreign key doesn't create an index on its own column, so this page of a store's orders reads every store's rows:

```sql
-- in app/sql/latest_orders.sql
select id, total_price from shopify_order where shop_id = $1 order by shopify_created_at desc limit 50;
```

On 20,000 orders across 200 stores, `explain` shows `Seq Scan on shopify_order`, and it gets slower as every store adds orders. Index each `belongsTo` column, and put the columns a query filters and sorts by in one index:

```sql
-- in db/migrations/shopify_order_shop_created_index.sql
create index shopify_order_shop_id_shopify_created_at_idx on shopify_order (shop_id, shopify_created_at desc);
```

The same `explain` then shows `Index Scan using shopify_order_shop_id_shopify_created_at_idx`. Build indexes after the import, which is faster than updating them on every inserted row. On a table that already serves traffic, use `create index concurrently` ([environments.md](environments.md)). The inventory script lists every `belongsTo` field under Relationships.

**Uniqueness ignores case on Gadget.** A `unique` validation on a `string`, `email`, `url`, or `richText` field compares `A@x.com` and `a@x.com` as equal unless it sets `caseSensitive: true`, and can be scoped to another field with `scopeByField`. A plain unique index allows both:

```sql
-- in db/migrations/widget_unique_sku.sql
create unique index widget_sku_per_shop on widget (shop_id, lower(sku));
```

Gadget enforces uniqueness with an index of its own, so exported records never break this one. Like Gadget, the index allows any number of rows where the column is null. Prisma's `@@unique` can't express `lower()`, so keep this index in a SQL migration.

**Required rejects empty strings on Gadget.** Use `not null` plus `check (name <> '')` for text. Gadget checks `required` and the other validations only when an action saves a record, so rows written through the Internal API, or saved before you added the validation, can still be null or empty. Count them before you add the constraint:

```sql
-- in db/checks/widget_missing_names.sql
select count(*) from widget where name is null or name = '';
```

**Record states are nested.** The `state` field on `shopifyShop` exports as `{ "created": "installed" }` or `{ "created": "uninstalled" }`, not as a string. Store the inner name, `installed` or `uninstalled`, and filter on it wherever your Gadget code filtered on `state: { equals: "created.installed" }`.

**Vectors fit pgvector's index limit.** Gadget caps `vector` fields at 2,000 dimensions, the most a pgvector index on a `vector` column supports. Gadget indexed them with HNSW and cosine distance:

```sql
-- in db/migrations/widget_embedding_index.sql
create index widget_embedding on widget using hnsw (embedding vector_cosine_ops);
```

Similarity queries change shape too: [other-connections.md](other-connections.md) shows how Gadget's `cosineSimilarity` becomes pgvector's `<=>` distance.

**Shopify money fields are strings.** `totalPrice` on `shopifyOrder` is a `string` field on Gadget, because Shopify sends money as strings. Convert to `numeric` when you load it if you sum or compare it.

**Shopify metafield fields are Shopify's data.** A field with a `shopifyMetafield` block in `schema.gadget.ts` mirrors a metafield. Give it a column, and fill it from the metafield in your backfill and webhook handlers instead of from the export ([shopify-sync.md](shopify-sync.md)).

## Computed fields

Computed fields are Gelly expressions with no direct equivalent. A field that sums a customer's orders:

```gelly
field on ShopifyCustomer {
  sum(cast(orders.totalPrice, type: "Number"))
}
```

becomes a view. The left join keeps customers with no orders, the way a computed field exists on every record:

```sql
-- in db/migrations/customer_total_order_value.sql
create view customer_total_order_value as
select shopify_customer.id as customer_id, sum(shopify_order.total_price) as total_order_value
from shopify_customer
left join shopify_order on shopify_order.customer_id = shopify_customer.id
group by shopify_customer.id;
```

A generated column only works when the value uses fields on the same row, since generated columns can't read other rows.

Computed views, the `.gelly` files in `api/views` and the queries passed to `api.view()`, are a separate feature. The inventory script lists them, and [computed-views.md](computed-views.md) covers replacing them.

## Move sequences after loading

Tables with their own id sequence start counting at 1. After loading exported records, move the sequence past the highest id, or the first new record collides with an imported one:

```sql
-- in db/after_import.sql
select setval(pg_get_serial_sequence('widget', 'id'), coalesce((select max(id) from widget), 0) + 1000000);
```

The gap of 1,000,000 is for the records Gadget keeps creating between the export and the switch. They arrive in the catch-up load with Gadget's next ids, and without the gap the new app hands out the same ids to its own records. Make the gap larger than the number of records Gadget could create in that window ([Reset id sequences](https://docs.gadget.dev/guides/moving-to-another-platform#reset-id-sequences)).

Keep the `coalesce` for a model with no exported records: there `max(id)` is null, `setval` with a null value changes nothing, and the sequence stays at 1, so Gadget's first record after the export and the new app's first record both get id 1. Tables for Shopify models use Shopify's ids and have no sequence.

## A Shopify model and a custom model in Prisma

```prisma
// in prisma/schema.prisma
model ShopifyShop {
  id               BigInt   @id // Shopify's id, never generated
  myshopifyDomain  String   @map("myshopify_domain")
  state            String   @default("installed")
  orders           ShopifyOrder[]
  widgets          Widget[]

  @@map("shopify_shop")
}

model ShopifyOrder {
  id               BigInt    @id
  shopId           BigInt    @map("shop_id")
  totalPrice       Decimal?  @map("total_price") @db.Decimal
  financialStatus  String?   @map("financial_status")
  shopifyCreatedAt DateTime? @map("shopify_created_at") @db.Timestamptz
  shopifyUpdatedAt DateTime? @map("shopify_updated_at") @db.Timestamptz
  reviewed         Boolean   @default(false) // a field your app added
  shop             ShopifyShop @relation(fields: [shopId], references: [id])

  @@index([shopId])
  @@map("shopify_order")
}

model Widget {
  id        BigInt    @id @default(autoincrement())
  shopId    BigInt    @map("shop_id")
  name      String
  sku       String?
  price     Decimal?  @db.Decimal
  tags      String[]
  dueOn     DateTime? @map("due_on") @db.Date
  createdAt DateTime  @default(now()) @map("created_at") @db.Timestamptz
  updatedAt DateTime  @default(now()) @updatedAt @map("updated_at") @db.Timestamptz
  shop      ShopifyShop @relation(fields: [shopId], references: [id])

  @@index([shopId, id])
  @@map("widget")
}
```

`@updatedAt` makes Prisma set `updated_at` on every write it makes, and `@default(now())` covers rows inserted any other way. Writes that skip Prisma need `updated_at` set too ([data-export.md](data-export.md) explains why). Load exported records with SQL, as in [data-export.md](data-export.md), so they keep the `updatedAt` Gadget gave them.

## Common pitfalls

- **`double precision` for numbers.** Totals drift.
- **Generating new ids.** Every relationship breaks. Keep the exported ids.
- **Adding foreign keys before checking for orphans.** The migration fails on records Gadget allowed.
- **No index on `shop_id`.** Every store-scoped query reads the whole table, and nothing fails until the table grows.
- **Adding `not null` before counting nulls.** Validations never checked records written through the Internal API.
- **A case-sensitive unique index.** Allows duplicates Gadget rejected.
- **A table named `user`.** A syntax error in Postgres. Use `users`.
- **Forgetting `setval`.** The first insert after import fails with a duplicate key.

## Related references

- [data-export.md](data-export.md): getting the records out
- [shop-tenancy.md](shop-tenancy.md): policies for every table with a `shop_id`
- [computed-views.md](computed-views.md): replacing computed views
- [files-and-storage.md](files-and-storage.md): the columns and code that replace a file field
