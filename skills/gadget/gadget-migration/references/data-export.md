# Exporting data from Gadget

## What is this?

Gadget stores each model's records in Postgres, but you can't connect to that database. Records leave through one of two doors:

| | Data editor CSV export | Internal API |
|---|---|---|
| Scope | One model, records matching the current search | Any model, any filter |
| Speed | One export per environment at a time, emailed as a link valid for 3 days | 250 records per request, as fast as your rate limits allow |
| Restartable | No | Yes, from the last cursor |
| Good for | Models under about 250,000 records, and spot checks | Everything else |

Both count against the environment's request and database rate limits, so run large exports outside busy hours.

Run `scripts/inventory.ts` first. Its model table says which models to export, which to backfill from Shopify, and which to skip.

## Export with the Internal API

The Internal API reads every stored field, including ones the Public API hides, and ignores your roles' permissions and filters. It only accepts system admin callers: create an API key in the **production** environment's **Settings** > **API keys** and turn **Access control** off. Delete the key when the export is done.

This script writes one model to newline-delimited JSON. It waits and retries when a request fails, and a second run continues from the last page the first one finished:

```typescript
// in scripts/export-model.ts
import { Client } from "@gadget-client/my-app";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

// usage: node scripts/export-model.ts widget
//        node scripts/export-model.ts billing/invoice 2026-11-01T00:00:00Z
const [model, since] = process.argv.slice(2);
const api = new Client({ environment: "Production", authenticationMode: { apiKey: process.env.GADGET_EXPORT_API_KEY! } });

// a namespaced model such as billing/invoice lives at api.internal.billing.invoice
const manager = model.split("/").reduce((node: any, part) => node?.[part], api.internal);
if (!manager?.findMany) throw new Error(`no model named ${model}`);

const name = model.replaceAll("/", ".") + (since ? ".changes" : "");
const output = `${name}.ndjson`;
const checkpoint = `${name}.cursor`;
// with a second argument, export only records changed after that time
const filter = since ? { updatedAt: { greaterThan: since } } : undefined;

async function fetchPage(after: string | undefined) {
  for (let attempt = 1; ; attempt++) {
    try {
      // without a select, the Internal API returns every stored field
      return await manager.findMany({ first: 250, after, filter });
    } catch (error) {
      // the client doesn't retry rate limit errors or dropped connections, so wait and try again
      if (attempt === 8) throw error;
      const seconds = Math.min(60, 2 ** attempt);
      console.error(`request failed (${(error as Error).message}), trying again in ${seconds}s`);
      await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
    }
  }
}

let cursor = existsSync(checkpoint) ? readFileSync(checkpoint, "utf8").trim() || undefined : undefined;
let exported = 0;

for (;;) {
  const page = await fetchPage(cursor);
  if (page.length) appendFileSync(output, page.map((record: unknown) => JSON.stringify(record)).join("\n") + "\n");
  exported += page.length;
  if (!page.hasNextPage) break;
  cursor = page.endCursor;
  writeFileSync(checkpoint, cursor!); // written after the page, so a restart never skips records
}

console.log(`exported ${exported} records from ${model}`);
```

At 250 records per request, a 2.4 million record model takes 9,600 requests. Pages come back in id order, so a restart from the saved cursor continues where it left off. If a run dies between writing a page and saving the cursor, the restart writes that page again, so load the file with an upsert on `id`, not a plain insert:

```sql
-- in db/load_widget.sql
-- widget_import has one jsonb column, doc, holding one exported record per row
insert into widget (id, shop_id, name, sku, created_at, updated_at)
select distinct on ((doc->>'id')::bigint)
  (doc->>'id')::bigint,
  (doc->>'shop')::bigint,
  doc->>'name',
  doc->>'sku',
  (doc->>'createdAt')::timestamptz,
  (doc->>'updatedAt')::timestamptz
from widget_import
order by (doc->>'id')::bigint, (doc->>'updatedAt')::timestamptz desc
on conflict (id) do update
set shop_id = excluded.shop_id, name = excluded.name, sku = excluded.sku, updated_at = excluded.updated_at
where widget.updated_at <= excluded.updated_at;
```

The `distinct on` keeps the newest copy when a record appears twice in one file. Without it, Postgres rejects the statement with `ON CONFLICT DO UPDATE command cannot affect row a second time`.

The `where` clause stops the catch-up load from putting Gadget's older copy over a row the new app changed, but only if the new app moved `updated_at` when it changed the row. If the new app updates record 42 at 11:10 with plain SQL that leaves `updated_at` at 09:00, the 11:20 catch-up load writes Gadget's 10:05 copy over the change ([the guide's example](https://docs.gadget.dev/guides/moving-to-another-platform#load-your-records)). Gadget set `updatedAt` to `statement_timestamp()` on every update and upsert, and the new app has to do the same. Prisma's `@updatedAt` covers only the writes Prisma makes. For every other writer, set `updated_at` in the update or add a trigger. Either way, give `created_at` and `updated_at` a default of `now()`, because Gadget set both and the schema files list neither.

A trigger that always writes the current time breaks the load instead: it stamps each loaded row with the time of the load, so the next catch-up skips a change Gadget made between that export and that load. This one fills in `updated_at` only when an update changed the row and left the column alone:

```sql
-- in db/migrations/widget_updated_at.sql
create function set_updated_at() returns trigger language plpgsql as $$
begin
  -- the load sets updated_at itself, and a load that repeats a copy the table has changes nothing
  if new.updated_at is not distinct from old.updated_at and new is distinct from old then
    new.updated_at := statement_timestamp();
  end if;
  return new;
end;
$$;

create trigger widget_set_updated_at before update on widget
for each row execute function set_updated_at();
```

This function fills `widget_import` from the file, 1,000 lines per insert. It avoids `copy`, whose text format treats the backslashes inside JSON strings as its own escapes:

```typescript
// in scripts/load-ndjson.ts
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { Pool } from "pg";

// table is a name you chose, never user input
export async function loadNdjson(pool: Pool, file: string, table: string): Promise<number> {
  let batch: string[] = [];
  let loaded = 0;
  const flush = async () => {
    if (!batch.length) return;
    await pool.query(`insert into ${table} (doc) select value from jsonb_array_elements($1::jsonb)`, [`[${batch.join(",")}]`]);
    loaded += batch.length;
    batch = [];
  };
  for await (const line of createInterface({ input: createReadStream(file) })) {
    if (!line.trim()) continue;
    batch.push(line);
    if (batch.length === 1000) await flush();
  }
  await flush();
  return loaded;
}
```

## Catch up on records that change during the export

The export is not a snapshot. It reads pages over minutes or hours while your app keeps writing, so a record that changes after its page was read is stale in the file. Three steps close the gap:

1. **Note the time before the first export starts.**
2. **Export changes after traffic stops.** Pass that time as the second argument, and the script writes only records with a newer `updatedAt` to `widget.changes.ndjson`. Load it with the same upsert. Run it once before cutover to shrink the gap and once after writes to Gadget stop.
3. **Remove deleted records.** A deleted record is gone from Gadget, so no export mentions it. Export the ids again with `select: ["id"]` and delete rows in your table whose id is missing. Delete only after that id export reached its last page, where `hasNextPage` is false. A run that stopped at 1.8 million of 2.4 million ids lists 600,000 live records as missing, and the delete removes all of them.

Gadget sets `updatedAt` on every save, through an action or the Internal API, unless your code writes `updatedAt` itself. The upsert above compares Gadget's `updatedAt`, so keep that value in your table and don't replace it with the time you loaded the row.

## Values that need care

| Field type | What the Internal API returns | What to do |
|---|---|---|
| id | A number in a string, such as `"123"` | Keep it. Relationships point at it |
| Shopify model ids | The Shopify resource id, such as `"5123456789"` | Keep it. `shopifySync` and `shopifyGdprRequest` records are Gadget's own and use Gadget ids |
| BelongsTo | The related id in a string, under the field's name, such as `"shop": "42"` | Load into the `shop_id` column. Inside actions the same value is `record.shopId` |
| Number | A JSON number | Exact up to about 15 significant digits. Gadget stored a `decimal`, so longer values lose precision on the way out |
| DateTime | An ISO string in UTC, such as `"2026-11-07T00:00:00.000Z"` | Load into `timestamptz`. For a field without a time, cast to `date` |
| Enum | A string, or an array when the field allows several values. An empty multiple-value field is `[]`, not `null` | |
| RichText | `{ "markdown": "..." }` | Store the `markdown` string |
| JSON | The stored value, which can be an object, array, string, number, or boolean | Load into `jsonb` |
| Vector | An array of numbers | Load into a pgvector column |
| Password | `{ "hash": "$2b$10$..." }` | A bcrypt hash. See [users-and-auth.md](users-and-auth.md) |
| EncryptedString | The decrypted plaintext | Gadget holds the key. Encrypt it again on the new platform before you store it |
| File | `{ url, fileName, mimeType, byteSize, storageToken }` | Download from `url` soon after reading: private file URLs expire after 3 hours. Drop `storageToken`, which only Gadget can read |
| RoleAssignments | Role names, such as `["shopify-app-users"]` | The CSV export writes role keys instead, such as `Role-Shopify-App` |
| `state` on `shopifyShop` | A nested object, such as `{ "created": "installed" }` | Store `installed` or `uninstalled`. See [schema-mapping.md](schema-mapping.md) |
| `shopifyShop` tokens | `accessToken`, `refreshToken`, and their expiry times | Read [shopify-tokens.md](shopify-tokens.md) before using them |

Computed fields are left out unless you name them in `select`.

**Stored records can break your validations.** Gadget runs validations when an action saves a record. Records written through the Internal API, or saved before you added a validation, were never checked, and the Internal API returns them as they are. Count the nulls and empty strings in a column before you add `not null` to it ([schema-mapping.md](schema-mapping.md)).

## Copy files to new storage

Read each record, download its file right away, and upload it under a key you control:

```typescript
// in scripts/copy-files.ts
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

const s3 = new S3Client({});
for (const record of page) {
  const file = record.manual; // a File field
  if (!file?.url) continue;
  const response = await fetch(file.url); // private URLs expire 3 hours after the read
  if (!response.ok) throw new Error(`download failed for widget ${record.id}: ${response.status}`);
  await s3.send(new PutObjectCommand({
    Bucket: process.env.BUCKET!,
    Key: `widget/${record.id}/manual/${file.fileName}`,
    Body: Buffer.from(await response.arrayBuffer()),
    ContentType: file.mimeType,
  }));
}
```

`Buffer.from(await response.arrayBuffer())` holds the whole file in memory. Gadget accepts direct uploads up to 10 GB, so if your app used them, stream the response body with `Upload` from `@aws-sdk/lib-storage`. [files-and-storage.md](files-and-storage.md) covers uploads and downloads after the move.

Store the key, file name, MIME type, and size in the new table. Public file URLs you stored elsewhere, such as in Shopify metafields or emails, should point at the new storage before you delete the Gadget app. Gadget doesn't guarantee they keep working after that.

## Export from the data editor

Use the CSV export for small models only. It works reliably up to about 250,000 records, and wide records fail sooner: 500,000 `shopifyOrder` records can run the export out of memory. A failed export starts again from the first record, and when every attempt fails, no email arrives. For anything larger, use the Internal API script above. If a browser download of the file stops partway, download it again from the start, because resuming it can corrupt the file.

Open the model, then **More options** > **Export to CSV**. The export includes every stored field, including hidden ones such as `shopifyShop.accessToken`, and leaves out computed fields and related models. Gadget sends no email when no records match. Values to convert on import:

- **DateTime:** milliseconds since 1 January 1970, such as `1762473600000`.
- **Number:** a plain number, such as `12.5`.
- **Boolean:** `1` for true and an empty cell for false. A boolean that was never set is also an empty cell.
- **RichText, File, Password, JSON objects, RoleAssignments, and Enum fields with several values:** JSON, such as `{"markdown":"..."}` or `["new","sale"]`.
- **BelongsTo:** a column named after the field, such as `customer`, holding the related id.
- **RoleAssignments:** role keys, not names. A role's key is its `storageKey` in `accessControl/permissions.gadget.ts`: `Role-Shopify-App` for `shopify-app-users`, `sysadmin` for `system-admin`.
- **Password and EncryptedString:** the bcrypt hash and the plaintext. Keep the file somewhere only you can read it.
- **Null and empty string:** both are an empty cell, so the CSV can't tell them apart. Use the Internal API when the difference matters.

## Shopify models

Don't export records in Shopify models. Backfill them from Shopify instead ([shopify-sync.md](shopify-sync.md)), and export only the fields your app added to them, such as a `reviewed` flag on `shopifyOrder`:

```typescript
// in scripts/export-added-fields.ts
const page = await api.internal.shopifyOrder.findMany({ first: 250, after: cursor, select: ["id", "reviewed"] });
```

Join them back on the Shopify id after the backfill. Fields connected to a Shopify metafield are Shopify's data too, so the backfill covers them: read the metafields with the resource. The inventory script lists both kinds.

Three models are not Shopify's data, so Shopify can't give them back:

- **`shopifySync`** is Gadget's history of sync runs. Export it only if you want the history.
- **`shopifyGdprRequest`** is Gadget's record of each compliance webhook. Export it if you keep these as an audit trail.
- **`session`** holds browser sessions. Don't export it. Your new sign-in sessions, or Shopify session tokens, replace it.

## Common pitfalls

- **Exporting from development.** Development environments usually hold test data. Use production.
- **Changing ids on import.** Every BelongsTo that points at the record breaks.
- **Reading all records, then downloading all files.** By the time you reach the last file, its URL has expired.
- **Loading with plain inserts.** A restarted export repeats one page. Upsert on `id`.
- **Treating the first export as final.** Records changed during the export are stale. Run the catch-up export after writes stop.
- **Forgetting the sequence.** After loading a table with its own id sequence, move it past the highest id ([schema-mapping.md](schema-mapping.md)).

## Related references

- [schema-mapping.md](schema-mapping.md): the tables you load into
- [shopify-sync.md](shopify-sync.md): the backfill that replaces exporting Shopify models
- [files-and-storage.md](files-and-storage.md): file uploads and downloads after the move
- [cutover.md](cutover.md): when the final catch-up export runs
