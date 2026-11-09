# Exporting data from Gadget

## What is this?

Gadget stores each model's records in Postgres, but you can't connect to that database. Records leave through one of two doors:

| | Data editor CSV export | Internal API |
|---|---|---|
| Scope | One model, records matching the current search | Any model, any filter |
| Speed | One export per environment at a time, emailed as a link valid for 3 days | 250 records per request, as fast as your rate limits allow |
| Restartable | No | Yes, from the last cursor |
| Good for | Small models and spot checks | Everything else |

Both count against the environment's request and database rate limits, so run large exports outside busy hours.

## Export with the Internal API

The Internal API reads every stored field, including ones the Public API hides, and ignores your roles' permissions and filters. It only accepts system admin callers: create an API key in the **production** environment's **Settings** > **API keys** and turn **Access control** off. Delete the key when the export is done.

This script writes one model to newline-delimited JSON and can restart from where it stopped:

```typescript
// in scripts/export-model.ts
import { Client } from "@gadget-client/my-app";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const model = process.argv[2]; // such as "widget"
const api = new Client({ environment: "Production", authenticationMode: { apiKey: process.env.GADGET_EXPORT_API_KEY! } });
const output = `${model}.ndjson`;
const checkpoint = `${model}.cursor`;

let cursor = existsSync(checkpoint) ? readFileSync(checkpoint, "utf8").trim() || undefined : undefined;
let exported = 0;

for (;;) {
  // without a select, the Internal API returns every stored field
  const page = await (api.internal as any)[model].findMany({ first: 250, after: cursor });
  if (page.length) appendFileSync(output, page.map((record: unknown) => JSON.stringify(record)).join("\n") + "\n");
  exported += page.length;
  if (!page.hasNextPage) break;
  cursor = page.endCursor;
  writeFileSync(checkpoint, cursor!); // written after the page, so a restart never skips records
}

console.log(`exported ${exported} records from ${model}`);
```

At 250 records per request, a 2.4 million record model takes 9,600 requests. Pages come back in id order, so a restart from the saved cursor continues where it left off. If a run dies between writing a page and saving the cursor, the restart writes that page again, so load the file with an upsert on `id`, not a plain insert.

## Values that need care

| Field type | What the Internal API returns | What to do |
|---|---|---|
| id | A number in a string, such as `"123"` | Keep it. Relationships point at it |
| Shopify model ids | The Shopify resource id, such as `"5123456789"` | Keep it. Models Gadget creates itself, such as `shopifySync`, use Gadget ids |
| Number | A JSON number | Exact up to about 15 significant digits. Gadget stored a `decimal`, so longer values lose precision on the way out |
| DateTime | An ISO string | Load into `timestamptz` |
| Password | `{ "hash": "$2b$10$..." }` | A bcrypt hash. See [users-and-auth.md](users-and-auth.md) |
| EncryptedString | The decrypted plaintext | Gadget holds the key. Encrypt it again on the new platform before you store it |
| File | `{ url, mimeType, byteSize, fileName }` | Download from `url` soon after reading: private file URLs expire after 3 hours |
| RoleAssignments | Role names, such as `["signed-in"]` | The CSV export writes role keys instead, such as `sysadmin` for `system-admin` |
| `shopifyShop` tokens | `accessToken`, `refreshToken`, and their expiry times | Read [shopify-tokens.md](shopify-tokens.md) before using them |

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

Store the key, file name, MIME type, and size in the new table. Public file URLs you stored elsewhere, such as in Shopify metafields or emails, should point at the new storage before you delete the Gadget app. Gadget doesn't guarantee they keep working after that.

## Export from the data editor

Open the model, then **More options** > **Export to CSV**. The export includes every stored field, including hidden ones such as `shopifyShop.accessToken`, and leaves out computed fields and related models. Values to convert on import:

- **DateTime:** milliseconds since 1 January 1970, such as `1762473600000`.
- **Number:** a JSON string with the quote marks inside the cell, such as `"12.5"`.
- **Boolean:** `1` for true and an empty cell for false.
- **File and RichText:** JSON objects.
- **BelongsTo:** a column named after the field, such as `customer`, holding the related id.
- **Password and EncryptedString:** the bcrypt hash and the plaintext. Keep the file somewhere only you can read it.

## Shopify models

Don't export records in Shopify models. Backfill them from Shopify instead ([shopify-sync.md](shopify-sync.md)), and export only the fields your app added to them, such as a `reviewed` flag on `shopifyOrder`. Join them back on the Shopify id after the backfill.

## Common pitfalls

- **Exporting from development.** Development environments usually hold test data. Use production.
- **Changing ids on import.** Every BelongsTo that points at the record breaks.
- **Reading all records, then downloading all files.** By the time you reach the last file, its URL has expired.
- **Loading with plain inserts.** A restarted export repeats one page. Upsert on `id`.
- **Forgetting the sequence.** After loading a table with its own id sequence, move it past the highest id ([schema-mapping.md](schema-mapping.md)).

## Related references

- [schema-mapping.md](schema-mapping.md): the tables you load into
- [shopify-sync.md](shopify-sync.md): the backfill that replaces exporting Shopify models
