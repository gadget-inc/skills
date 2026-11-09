# Mapping Gadget models to database tables

## What is this?

Each Gadget model becomes a table, and each stored field becomes a column. Gadget's internal column names mean nothing outside Gadget, so name columns after the field's API identifier, in snake_case: `totalPrice` becomes `total_price`. The field types are in each model's `schema.gadget.ts`, and `scripts/inventory.ts` lists them.

## Field types

| Gadget field type (`type:` in `schema.gadget.ts`) | Postgres column | Prisma |
|---|---|---|
| id | `bigint` primary key. Keep the exported values | `BigInt @id @default(autoincrement())`, or `BigInt @id` for Shopify models |
| `string`, `email`, `url`, `color` | `text`, with a `check` for validations you relied on | `String` |
| `number` | `numeric` | `Decimal` |
| `boolean` | `boolean` | `Boolean` |
| `dateTime` | `timestamptz`, or `date` when `includeTime` is false | `DateTime @db.Timestamptz` |
| `enum` | `text` with a `check`, unless the field allows other values | `String`, or a Prisma `enum` |
| `enum` with `acceptMultipleSelections` | `text[]` | `String[]` |
| `json` | `jsonb` | `Json` |
| `richText` | `text` holding the markdown | `String` |
| `vector` | `vector(n)` from pgvector, where `n` is the embedding length | `Unsupported("vector(1536)")` |
| `file` | Columns for the storage key, file name, MIME type, and size | Four fields |
| `encryptedString` | `text`, encrypted by your app or a key service | `String` |
| `password` | Usually lives in your sign-in provider | |
| `roleList` | `text[]` | `String[]` |
| `money` | `numeric`, plus the currency code | `Decimal` |
| `recordState` | `text` holding the state name | `String` |
| `belongsTo` | `bigint` column | `BigInt` plus a `@relation` |
| `hasOne`, `hasMany` | No column. The other table holds the key | A relation field |
| `hasManyThrough` | The join model's table, exported like any other model | Two relations through the join model |
| `computed` | A view or a query | Nothing stored |

## Decisions the table hides

**Numbers are exact on Gadget.** Gadget stores `number` fields in a Postgres `decimal` column. In a `double precision` column, `0.1 + 0.2` is `0.30000000000000004`, so order totals drift as you sum them. Use `numeric`.

**Gadget enforces no foreign keys.** A `belongsTo` can point at a record that no longer exists. Find those before you add a constraint, or the migration fails:

```sql
-- in db/checks/orphaned_widgets.sql
select widget.id, widget.shop_id
from widget
left join shopify_shop on shopify_shop.id = widget.shop_id
where widget.shop_id is not null
  and shopify_shop.id is null;
```

**Uniqueness ignores case on Gadget.** A `unique` validation on a string compares `A@x.com` and `a@x.com` as equal unless it's case sensitive, and can be scoped to another field. A plain unique index allows both:

```sql
-- in db/migrations/widget_unique_sku.sql
create unique index widget_sku_per_shop on widget (shop_id, lower(sku));
```

**Required rejects empty strings on Gadget.** Use `not null` plus `check (name <> '')` for text.

**Vectors fit pgvector's index limit.** Gadget caps `vector` fields at 2,000 dimensions, the most a pgvector `vector` index supports. Gadget indexed them with HNSW and cosine distance:

```sql
-- in db/migrations/widget_embedding_index.sql
create index widget_embedding on widget using hnsw (embedding vector_cosine_ops);
```

**Shopify money fields are strings.** `totalPrice` on `shopifyOrder` is a `string` field on Gadget, because Shopify sends money as strings. Convert to `numeric` when you load it if you sum or compare it.

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

## Move sequences after loading

Tables with their own id sequence start counting at 1. After loading exported records, move the sequence past the highest id, or the first new record collides with an imported one:

```sql
-- in db/after_import.sql
select setval(pg_get_serial_sequence('widget', 'id'), (select max(id) from widget));
```

On an empty table this does nothing, which is fine. Tables for Shopify models use Shopify's ids and have no sequence.

## A Shopify model and a custom model in Prisma

```prisma
model ShopifyOrder {
  id               BigInt    @id // Shopify's id, never generated
  shopId           BigInt    @map("shop_id")
  totalPrice       Decimal   @map("total_price") @db.Decimal
  financialStatus  String?   @map("financial_status")
  shopifyCreatedAt DateTime? @map("shopify_created_at") @db.Timestamptz
  shopifyUpdatedAt DateTime? @map("shopify_updated_at") @db.Timestamptz
  reviewed         Boolean   @default(false) // a field your app added
  shop             ShopifyShop @relation(fields: [shopId], references: [id])

  @@index([shopId])
  @@map("shopify_order")
}

model Widget {
  id     BigInt   @id @default(autoincrement())
  shopId BigInt   @map("shop_id")
  name   String
  sku    String?
  price  Decimal? @db.Decimal
  tags   String[]

  @@map("widget")
}
```

## Common pitfalls

- **`double precision` for numbers.** Totals drift.
- **Generating new ids.** Every relationship breaks. Keep the exported ids.
- **Adding foreign keys before checking for orphans.** The migration fails on records Gadget allowed.
- **A case-sensitive unique index.** Allows duplicates Gadget rejected.
- **Forgetting `setval`.** The first insert after import fails with a duplicate key.

## Related references

- [data-export.md](data-export.md): getting the records out
- [shop-tenancy.md](shop-tenancy.md): policies for every table with a `shop_id`
