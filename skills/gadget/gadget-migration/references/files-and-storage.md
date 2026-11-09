# Replacing file fields and uploads

## What is this?

A Gadget file field hides a storage bucket. The field accepted uploads four ways, handed back a URL on every read, signed that URL when the field was private, and deleted the stored object when the record went away. On another platform each of those is code you write against a bucket.

[data-export.md](data-export.md) covers copying the existing files out. This reference covers what the app does from then on. The inventory script lists every file field. The default `user` model has one, `profilePicture`, even when the app never uploads anything, so check whether the field is used before building for it.

## What the field did, and what replaces it

| Gadget | Replacement |
|---|---|
| `{ file }`: the browser sent the file to Gadget in the same request, up to 100 MB | A direct upload, or a route that streams the body to the bucket |
| `{ directUploadToken }`: the browser uploaded to storage with a URL from `api.getDirectUploadToken()`, then passed the token to an action, up to 10 GB | A presigned upload URL from your own route |
| `{ copyURL }`: Gadget downloaded the file from a URL, up to 100 MB | `fetch` the URL in a job and stream it to the bucket |
| `{ base64 }`: file contents inline in the request, up to 10 MB | Decode and upload from the server |
| `record.file.url` on a public field: a URL that never expires | A public bucket or CDN domain plus the object key |
| `record.file.url` on a private field: a signed URL valid for 3 hours, only for callers allowed to read the record | A presigned download URL, made after your own permission check |
| File size and image-only validations | Checks in the route that issues the upload URL, and again after the upload |
| Deleting the record, clearing the field, or replacing the file deleted the stored object | A delete call you make, or a cleanup job |

S3, Cloudflare R2, Google Cloud Storage, and Supabase Storage all support the pattern below. The code uses the S3 API, which R2 and most others also accept.

## Store the key, not the URL

```sql
-- in db/migrations/widget_manual_file.sql
alter table widget
  add column manual_key text,          -- "widgets/42/manual/8f3c1a2b-guide.pdf"
  add column manual_file_name text,    -- "guide.pdf"
  add column manual_mime_type text,
  add column manual_byte_size bigint;
```

### ❌ Storing the URL

```sql
alter table widget add column manual_url text; -- "https://my-bucket.s3.us-east-1.amazonaws.com/widgets/42/..."
```

A stored URL names one bucket, one region, and one provider. Moving storage again, adding a CDN, or making the field private means rewriting every row. A presigned URL stored this way stops working when it expires. Build the URL from the key each time you read.

## ✅ Direct uploads

The browser asks your server for a place to put the file, uploads straight to storage, then tells your server it finished. The file's bytes never pass through your app, which is what made Gadget's direct uploads work for large files.

```typescript
// in app/routes/api.uploads.ts
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomUUID } from "node:crypto";

// WHEN_REQUIRED stops the SDK from adding a checksum of an empty body to presigned URLs
const s3 = new S3Client({ requestChecksumCalculation: "WHEN_REQUIRED" });
const MAX_BYTES = 25 * 1024 * 1024;
const ALLOWED = new Set(["application/pdf", "image/png", "image/jpeg"]);

export async function createUpload(shopId: string, widgetId: string, file: { name: string; type: string; size: number }) {
  if (!ALLOWED.has(file.type)) throw new Response("file type not allowed", { status: 422 });
  if (file.size > MAX_BYTES) throw new Response("file too large", { status: 422 });

  // the key is built on the server: the client never chooses where the object goes
  const safeName = file.name.replace(/[^\w.-]+/g, "_").slice(-100);
  const key = `shops/${shopId}/widgets/${widgetId}/manual/${randomUUID()}-${safeName}`;

  const url = await getSignedUrl(
    s3,
    new PutObjectCommand({ Bucket: process.env.BUCKET!, Key: key, ContentType: file.type, ContentLength: file.size }),
    // without signableHeaders the type is not part of the signature, and the uploader can send any type
    { expiresIn: 15 * 60, signableHeaders: new Set(["content-type", "content-length"]) }
  );
  return { url, key };
}
```

The browser sends `PUT` to `url` with the same `Content-Type` and a body of exactly the size it reported, then calls a second route with `key`. Storage rejects an upload whose type or length differs from what was signed. The second route confirms the object before it writes the row:

```typescript
// in app/routes/api.uploads.complete.ts
import { HeadObjectCommand } from "@aws-sdk/client-s3";

export async function completeUpload(shopId: string, widgetId: string, key: string) {
  // the key came back from the browser, so check it belongs to this store and record
  if (!key.startsWith(`shops/${shopId}/widgets/${widgetId}/manual/`)) throw new Response(null, { status: 403 });

  const head = await s3.send(new HeadObjectCommand({ Bucket: process.env.BUCKET!, Key: key }));
  if ((head.ContentLength ?? 0) > MAX_BYTES) throw new Response("file too large", { status: 422 });

  await saveWidgetManual(shopId, widgetId, {
    key,
    fileName: key.split("/").pop()!.slice(37), // drop the uuid and the dash
    mimeType: head.ContentType ?? "application/octet-stream",
    byteSize: head.ContentLength ?? 0,
  });
}
```

The size and type in the first call are what the browser said it would send. `HeadObject` reads what landed. Check there too: not every S3-compatible store enforces a signed length, and the type is only a label the uploader chose.

Recent versions of the AWS SDK add a default checksum to every request. On a presigned `PUT` that checksum is computed for an empty body, so the URL carries `x-amz-checksum-crc32=AAAAAA==` and the real upload does not match it. `requestChecksumCalculation: "WHEN_REQUIRED"` on the client leaves it off.

The bucket needs a CORS rule that allows `PUT` from your app's origin with the `Content-Type` header, or the browser blocks the upload before it starts.

## ✅ Private files

Keep the bucket private. When a page needs the file, check that the caller may read the record, then sign a short-lived URL:

```typescript
// in app/services/files.server.ts
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const s3 = new S3Client({});

export function downloadUrl(key: string, fileName: string) {
  return getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: process.env.BUCKET!,
      Key: key,
      ResponseContentDisposition: `attachment; filename="${fileName.replace(/["\\\r\n]/g, "_")}"`,
    }),
    { expiresIn: 60 * 60 }
  );
}
```

Call it in the loader, after the store-scoped query found the row. The permission check is that query: a caller who can't load the row never gets a key to sign.

## Public files

Serve them from a public bucket or a CDN in front of it, on a domain you own, such as `https://files.example.com/<key>`. A domain you own is what lets the next storage move happen without changing a URL. Public URLs that pointed at Gadget's storage and were saved elsewhere, in emails, Shopify metafields, or other sites, need replacing before the Gadget app is deleted ([data-export.md](data-export.md)).

## Deleting

Gadget removed a stored file when its record was deleted, when the field was set to null, and when a new file replaced it. Nothing does that now. Either delete the object in the same function that deletes or replaces the row, after the transaction commits, or run a scheduled job that lists keys with no matching row and removes them.

Uploads that never complete leave objects behind too. Add a lifecycle rule or a job that deletes objects older than a day with no row pointing at them.

## Common pitfalls

- **Letting the client choose the key.** A caller overwrites another store's file by naming its key. Build keys on the server and check the prefix when the key comes back.
- **Trusting the reported size and type.** Check the stored object.
- **No CORS rule on the bucket.** Uploads fail in the browser and work from `curl`.
- **A presigned URL with a checksum of nothing.** Check the URL for `x-amz-checksum-crc32`. If it is there, set `requestChecksumCalculation: "WHEN_REQUIRED"`.
- **Signing URLs for a list page.** A page of 250 records signs 250 URLs on every load. Sign when the user clicks, or only for the files shown.
- **Long expiry times to avoid thinking about it.** A 7-day URL pasted into a chat is a 7-day public file.
- **Serving user uploads from the app's own domain.** An uploaded HTML or SVG file runs scripts there. Use a separate domain and `Content-Disposition: attachment`.

## Related references

- [data-export.md](data-export.md): copying existing files out of Gadget
- [schema-mapping.md](schema-mapping.md): the columns that replace a file field
- [shop-tenancy.md](shop-tenancy.md): the query that acts as the permission check
