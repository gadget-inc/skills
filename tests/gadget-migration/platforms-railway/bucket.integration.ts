// The bucket client and public-file route in references/platforms/railway.md, with the AWS SDK and
// Railway's variable names. Signing is offline, so this needs no bucket: it checks the URLs the code
// builds and the limit the SDK puts on presigned URLs, which is shorter than the 90 days Railway allows.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { block } from "../platform-blocks.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
let dir: string;
let bucket: { signedGetUrl(key: string, expiresIn?: number): Promise<string> };
let route: { loader(args: { params: Record<string, string | undefined> }): Promise<Response> };

before(async () => {
  Object.assign(process.env, {
    BUCKET: "files-a1b2c3",
    ENDPOINT: "https://t3.storageapi.dev",
    REGION: "auto",
    ACCESS_KEY_ID: "tid_example",
    SECRET_ACCESS_KEY: "tsec_example",
  });
  mkdirSync(join(here, ".run"), { recursive: true });
  dir = mkdtempSync(join(here, ".run/bucket-"));
  mkdirSync(join(dir, "app/services"), { recursive: true });
  mkdirSync(join(dir, "app/routes"), { recursive: true });
  writeFileSync(join(dir, "app/services/bucket.server.ts"), block("railway.md", "app/services/bucket.server.ts"));
  // Node strips types from .ts files only, and the route has no JSX
  writeFileSync(join(dir, "app/routes/files.ts"), block("railway.md", "app/routes/files.$.tsx").replace('from "../services/bucket.server"', 'from "../services/bucket.server.ts"'));
  bucket = await import(join(dir, "app/services/bucket.server.ts"));
  route = await import(join(dir, "app/routes/files.ts"));
});
after(() => dir && rmSync(dir, { recursive: true, force: true }));

describe("the public file route", () => {
  it("redirects a public key to a fresh URL on the bucket's own host, signed for an hour", async () => {
    const response = await route.loader({ params: { "*": "public/widgets/42/manual.pdf" } });
    assert.equal(response.status, 302);
    const location = new URL(response.headers.get("Location")!);
    // virtual-hosted style, Railway's default for new buckets, on a domain that isn't the app's
    assert.equal(location.host, "files-a1b2c3.t3.storageapi.dev");
    assert.equal(location.pathname, "/public/widgets/42/manual.pdf");
    assert.equal(location.searchParams.get("X-Amz-Expires"), "3600");
    assert.equal([...location.searchParams.keys()].some((k) => k.startsWith("x-amz-checksum")), false);
    assert.equal(response.headers.get("Cache-Control"), "public, max-age=3300");
  });

  it("answers 404 for keys outside the public prefix and for dot segments", async () => {
    for (const key of ["private/invoices/1.pdf", "public/../private/invoices/1.pdf", "public//x", "", "publicity.pdf"]) {
      const response = await route.loader({ params: { "*": key } });
      assert.equal(response.status, 404, key);
    }
  });
});

describe("the bucket client", () => {
  it("signs path-style URLs for older buckets", async () => {
    process.env.BUCKET_PATH_STYLE = "true";
    const fresh = await import(`${join(dir, "app/services/bucket.server.ts")}?path-style`);
    delete process.env.BUCKET_PATH_STYLE;
    const url = new URL(await fresh.signedGetUrl("public/a.png"));
    assert.equal(url.host, "t3.storageapi.dev");
    assert.equal(url.pathname, "/files-a1b2c3/public/a.png");
  });

  it("signs for 7 days at most, though Railway accepts 90", async () => {
    const week = new URL(await bucket.signedGetUrl("public/a.png", 7 * 24 * 60 * 60));
    assert.equal(week.searchParams.get("X-Amz-Expires"), "604800");
    await assert.rejects(bucket.signedGetUrl("public/a.png", 90 * 24 * 60 * 60), {
      message: "Signature version 4 presigned URLs must have an expiration date less than one week in the future",
    });
  });
});
